import os
import json
import re
import subprocess
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, SecretStr
from sqlalchemy import Boolean, DateTime, Integer, String, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./research_os.db")
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {})
Session = sessionmaker(engine)

class Base(DeclarativeBase):
    pass

class Account(Base):
    __tablename__ = "compute_accounts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    label: Mapped[str] = mapped_column(String(100))
    username: Mapped[str] = mapped_column(String(100))
    credential: Mapped[str] = mapped_column(String)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    yield

app = FastAPI(title="AI Research OS API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[os.getenv("WEB_ORIGIN", "http://localhost:3000")], allow_methods=["*"], allow_headers=["*"])

class AccountCreate(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    username: str = Field(min_length=1, max_length=100)
    token: SecretStr

class TokenUpdate(BaseModel):
    token: SecretStr

def cipher():
    key = os.getenv("CREDENTIAL_ENCRYPTION_KEY")
    if not key:
        raise HTTPException(503, "Chưa cấu hình CREDENTIAL_ENCRYPTION_KEY trên server.")
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError):
        raise HTTPException(503, "CREDENTIAL_ENCRYPTION_KEY không hợp lệ.")

def encrypt(token: SecretStr) -> str:
    value = token.get_secret_value().strip()
    if not value:
        raise HTTPException(422, "Token không được để trống.")
    return cipher().encrypt(value.encode()).decode()

def public(account):
    return {"id": account.id, "label": account.label, "username": account.username, "verified": account.verified, "last_verified_at": account.last_verified_at}

def get_account(session, account_id):
    account = session.get(Account, account_id)
    if account is None:
        raise HTTPException(404, "Không tìm thấy kết nối.")
    return account

def run_kaggle(token, args):
    env = {k: v for k, v in os.environ.items() if not k.startswith("KAGGLE_")}
    env["KAGGLE_API_TOKEN"] = token
    try:
        with tempfile.TemporaryDirectory(prefix="research-os-kaggle-") as isolated_home:
            env.update(HOME=isolated_home, USERPROFILE=isolated_home, KAGGLE_CONFIG_DIR=isolated_home)
            result = subprocess.run([os.sys.executable, "-m", "kaggle", *args], env=env, capture_output=True, timeout=45, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise HTTPException(502, "Không thể kết nối Kaggle hoặc yêu cầu quá thời gian.")
    if result.returncode != 0:
        raise HTTPException(502, "Kaggle không trả dữ liệu. Kiểm tra token, quyền truy cập và kết nối mạng.")
    return result.stdout.decode("utf-8", errors="replace").strip()

def parse_cli_json(output):
    if output in ("Not found", "No quota information available"):
        return [], False
    truncated = output.startswith("Next Page Token = ")
    if truncated:
        output = output.split("\n", 1)[1] if "\n" in output else ""
    try:
        data = json.loads(output)
    except (ValueError, TypeError):
        raise HTTPException(502, "Kaggle trả về dữ liệu không đúng định dạng mong đợi.")
    if not isinstance(data, list):
        raise HTTPException(502, "Kaggle trả về dữ liệu không đúng định dạng mong đợi.")
    return data, truncated

@app.get("/api/accounts/{account_id}/notebook-logs")
def notebook_logs(account_id: int, ref: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_-]+(?:/[0-9]+)?", ref):
        raise HTTPException(422, "Tên notebook không hợp lệ. Hãy dùng owner/notebook.")
    with Session() as session:
        account = get_account(session, account_id)
        try:
            token = cipher().decrypt(account.credential.encode()).decode()
        except InvalidToken:
            raise HTTPException(503, "Không thể giải mã token. Kiểm tra khóa mã hóa.")
    env = {k: v for k, v in os.environ.items() if not k.startswith("KAGGLE_")}
    env["KAGGLE_API_TOKEN"] = token
    try:
        with tempfile.TemporaryDirectory(prefix="research-os-kaggle-") as isolated_home:
            env.update(HOME=isolated_home, USERPROFILE=isolated_home, KAGGLE_CONFIG_DIR=isolated_home)
            with tempfile.TemporaryFile() as output:
                result = subprocess.run([os.sys.executable, "-m", "kaggle", "kernels", "logs", ref], env=env, stdout=output, stderr=subprocess.DEVNULL, timeout=45, check=False)
                if result.returncode != 0:
                    raise HTTPException(502, "Không lấy được logs. Notebook có thể chưa có logs, không tồn tại hoặc tài khoản không có quyền truy cập.")
                size = output.tell()
                limit = 256 * 1024
                output.seek(max(0, size - limit))
                content = output.read().decode("utf-8", errors="replace").strip()
    except (OSError, subprocess.TimeoutExpired):
        raise HTTPException(502, "Không thể kết nối Kaggle hoặc yêu cầu quá thời gian.")
    return {"ref": ref, "content": content, "truncated": size > limit, "fetched_at": datetime.now(timezone.utc).isoformat()}

@app.post("/api/accounts/{account_id}/sync")
def sync_account(account_id: int):
    with Session() as session:
        account = get_account(session, account_id)
        try:
            token = cipher().decrypt(account.credential.encode()).decode()
        except InvalidToken:
            raise HTTPException(503, "Không thể giải mã token. Kiểm tra khóa mã hóa.")
    results = {"synced_at": datetime.now(timezone.utc).isoformat(), "quota": None, "notebooks": None, "notebooks_truncated": False, "errors": {}}
    for name, args in (("quota", ["quota", "--format", "json"]), ("notebooks", ["kernels", "list", "--mine", "--page-size", "200", "--format", "json"])):
        try:
            data, truncated = parse_cli_json(run_kaggle(token, args))
            results[name] = data
            if name == "notebooks":
                results["notebooks_truncated"] = truncated
        except HTTPException as exc:
            results["errors"][name] = exc.detail
    return results

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.get("/api/accounts")
def list_accounts():
    with Session() as session:
        return [public(a) for a in session.scalars(select(Account).order_by(Account.id.desc()))]

@app.post("/api/accounts", status_code=201)
def create_account(data: AccountCreate):
    label, username = data.label.strip(), data.username.strip()
    if not label or not username:
        raise HTTPException(422, "Tên kết nối và username không được để trống.")
    account = Account(label=label, username=username, credential=encrypt(data.token))
    with Session() as session:
        session.add(account)
        session.commit()
        session.refresh(account)
        return public(account)

@app.patch("/api/accounts/{account_id}/credential")
def update_credential(account_id: int, data: TokenUpdate):
    encrypted = encrypt(data.token)
    with Session() as session:
        account = get_account(session, account_id)
        account.credential = encrypted
        account.verified = False
        account.last_verified_at = None
        session.commit()
        return public(account)

@app.delete("/api/accounts/{account_id}", status_code=204)
def delete_account(account_id: int):
    with Session() as session:
        session.delete(get_account(session, account_id))
        session.commit()

@app.post("/api/accounts/{account_id}/verify")
def verify_account(account_id: int):
    with Session() as session:
        account = get_account(session, account_id)
        try:
            token = cipher().decrypt(account.credential.encode()).decode()
        except InvalidToken:
            raise HTTPException(503, "Không thể giải mã token. Kiểm tra khóa mã hóa.")
        # The CLI can fall back to credentials on disk if the supplied token is invalid.
        # Give every invocation an empty home/config directory to prevent cross-account access.
        env = {k: v for k, v in os.environ.items() if not k.startswith("KAGGLE_")}
        env["KAGGLE_API_TOKEN"] = token
        try:
            with tempfile.TemporaryDirectory(prefix="research-os-kaggle-") as isolated_home:
                env["HOME"] = isolated_home
                env["USERPROFILE"] = isolated_home
                env["KAGGLE_CONFIG_DIR"] = isolated_home
                result = subprocess.run([os.sys.executable, "-m", "kaggle", "quota"], env=env, capture_output=True, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise HTTPException(502, "Không thể kết nối Kaggle hoặc yêu cầu quá thời gian.")
        account.verified = result.returncode == 0
        account.last_verified_at = datetime.now(timezone.utc)
        session.commit()
        if not account.verified:
            raise HTTPException(502, "Không thể xác minh kết nối. Kiểm tra token, mạng và phiên bản Kaggle CLI.")
        return public(account)
