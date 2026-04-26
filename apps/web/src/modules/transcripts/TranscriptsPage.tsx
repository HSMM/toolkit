// Транскрибация (ТЗ 3.2.3 + E7). Полный UI — из прототипа (TranscriptionPage).

import { FileText } from "lucide-react";
import { StubPage } from "../StubPage";

export function TranscriptsPage() {
  return <StubPage Icon={FileText}
    title="Транскрибация"
    sub="Полный UI подключается из прототипа — загрузка аудио, очередь, viewer транскрипта с синхронизацией playback, поиск, экспорт."
  />;
}
