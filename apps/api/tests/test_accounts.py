import os
from unittest.mock import patch

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

os.environ["DATABASE_URL"] = "sqlite://"
os.environ["CREDENTIAL_ENCRYPTION_KEY"] = Fernet.generate_key().decode()
from sqlalchemy.pool import StaticPool
from app import main

# In-memory SQLite must share one connection across TestClient worker threads.
main.engine = main.create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
main.Session = main.sessionmaker(main.engine)

def test_account_lifecycle_and_secret_handling():
    with TestClient(main.app) as client:
        response = client.post("/api/accounts", json={"label":"Lab", "username":"researcher", "token":"first-secret"})
        assert response.status_code == 201
        account = response.json()
        assert "first-secret" not in response.text and "credential" not in account
        with main.Session() as session:
            assert session.get(main.Account, account["id"]).credential != "first-secret"
        with patch("app.main.subprocess.run") as runner:
            runner.return_value.returncode = 0
            checked = client.post(f"/api/accounts/{account['id']}/verify")
            assert checked.json()["verified"] is True
            assert runner.call_args.kwargs["env"]["KAGGLE_API_TOKEN"] == "first-secret"
        updated = client.patch(f"/api/accounts/{account['id']}/credential", json={"token":"new-secret"})
        assert not updated.json()["verified"]
        assert client.delete(f"/api/accounts/{account['id']}").status_code == 204
        assert client.get("/api/accounts").json() == []

def test_failed_verification_does_not_leak_token():
    with TestClient(main.app) as client:
        account = client.post("/api/accounts", json={"label":"Lab", "username":"a", "token":"secret"}).json()
        with patch("app.main.subprocess.run") as runner:
            runner.return_value.returncode = 1
            result = client.post(f"/api/accounts/{account['id']}/verify")
        assert result.status_code == 502
        assert "secret" not in result.text
        assert client.get("/api/accounts").json()[0]["verified"] is False
