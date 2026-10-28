import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Porto Gestão | Portaria e controle de acesso",
  description: "Gestão de portaria, pessoas, visitantes, veículos e controle de acesso.",
  icons: {
    icon: "/porto-icon.svg",
    shortcut: "/porto-icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="antialiased">{children}</body>
    </html>
  );
}

