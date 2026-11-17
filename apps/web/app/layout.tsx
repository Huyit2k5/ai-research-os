import type { Metadata } from "next";
import "./style.css";
import "./screens.css";
import "./auth.css";
export const metadata: Metadata = { title: "Kaggle Accounts | AI Research OS", description: "Quản lý kết nối Kaggle" };
export default function Layout({children}:{children:React.ReactNode}) { return <html lang="vi"><body>{children}</body></html>; }
