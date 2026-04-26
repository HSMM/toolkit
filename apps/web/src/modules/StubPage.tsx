import type { LucideIcon } from "lucide-react";
import { Empty } from "@/components/states";
import { useT } from "@/i18n";

/**
 * Заглушка для модулей-плейсхолдеров MVP (Мессенджеры/Контакты/Хелпдэск).
 * Также используется доменными модулями до того, как из прототипа подтянется
 * полный UI (E4.2/E4.3 финальный шаг).
 */
export function StubPage({ Icon, title, sub }: { Icon: LucideIcon; title: string; sub?: string }) {
  const { t } = useT();
  return (
    <Empty Icon={Icon}
      title={title || t("stub.title")}
      sub={sub || t("stub.subtitle")}
    />
  );
}
