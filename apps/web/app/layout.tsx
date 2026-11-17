import type { Metadata } from "next";
import "./style.css";
export const metadata: Metadata = { title: "Kaggle Accounts | AI Research OS", description: "Qu?n l? k?t n?i Kaggle" };
export default function Layout({children}:{children:React.ReactNode}) { return <html lang="vi"><body>{children}</body></html>; }
