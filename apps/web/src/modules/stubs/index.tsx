// MVP-заглушки навигации (ТЗ 3.2.4): Мессенджеры, Контакты, Хелпдэск.
// Эти модули не реализуются в MVP — только структура портала.

import { MessageSquare, Users, HelpCircle } from "lucide-react";
import { StubPage } from "../StubPage";

export function MessengersStub() {
  return <StubPage Icon={MessageSquare}
    title="Мессенджеры"
    sub="Раздел в разработке. Появится в одной из следующих версий портала."
  />;
}

export function ContactsStub() {
  return <StubPage Icon={Users}
    title="Списки контактов"
    sub="Раздел в разработке. Каталог сотрудников и контрагентов из Bitrix24 с поиском."
  />;
}

export function HelpdeskStub() {
  return <StubPage Icon={HelpCircle}
    title="Хелпдэск"
    sub="Раздел в разработке. Внутренние обращения сотрудников, тикетинг, SLA."
  />;
}
