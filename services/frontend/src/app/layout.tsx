import './globals.css';
import React from 'react';

export const metadata = {
  title: 'AI Payment Gateway & Smart Router',
  description: 'Distributed payment orchestration and chaos routing platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 min-h-screen flex flex-col font-sans">
        {children}
      </body>
    </html>
  );
}

