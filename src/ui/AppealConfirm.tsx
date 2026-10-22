/** Подтверждение апелляции на месте широкой кнопки: две узкие кнопки той же общей ширины. */
export function AppealConfirm({ onYes, onNo }: { onYes: () => void; onNo: () => void }) {
  return (
    <div className="appeal-confirm" role="group" aria-label="Апелляция">
      <button type="button" className="buzzer" aria-label="Да, мой ответ был верным" onClick={onYes}>Да</button>
      <button type="button" className="buzzer" aria-label="Нет, не надо апелляцию" onClick={onNo}>Нет</button>
    </div>
  )
}
