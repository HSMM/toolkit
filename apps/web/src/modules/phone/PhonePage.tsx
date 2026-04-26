// Софтфон: ТЗ 3.2.1 + эпик E5. Полный UI берётся из прототипа (объект SoftphonePage).
// Сейчас — заглушка; компонент будет заменён сразу после интеграции прототипа.

import { Phone } from "lucide-react";
import { StubPage } from "../StubPage";

export function PhonePage() {
  return <StubPage Icon={Phone}
    title="Софтфон"
    sub="Полный UI подключается из прототипа в E4.2/E4.3 — браузерный WebRTC-клиент к FreePBX, dial pad, история звонков, статусы."
  />;
}
