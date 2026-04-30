import type { ReactNode } from "react";

export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="sp-frame">
      {children}
    </div>
  );
}
