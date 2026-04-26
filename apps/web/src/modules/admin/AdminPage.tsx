// Админ-панель (ТЗ 3.3 + E8). Полный UI — из прототипа (Settings*).

import { Settings } from "lucide-react";
import { StubPage } from "../StubPage";

export function AdminPage() {
  return <StubPage Icon={Settings}
    title="Админ-панель"
    sub="Управление пользователями, политиками записи и retention, настройки FreePBX, запросы 152-ФЗ, audit-log viewer."
  />;
}
