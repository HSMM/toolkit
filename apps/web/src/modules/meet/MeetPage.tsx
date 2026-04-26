// ВКС на базе LiveKit (ТЗ 3.2.2 + E6). Полный UI — из прототипа (VcsPage).

import { Video } from "lucide-react";
import { StubPage } from "../StubPage";

export function MeetPage() {
  return <StubPage Icon={Video}
    title="Видеоконференции"
    sub="Полный UI подключается из прототипа — список встреч, модалка создания, экран встречи, waiting room для гостей."
  />;
}
