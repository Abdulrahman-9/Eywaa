/** يطبع ما حُمل عليه الصنف print-sheet وحده، ويخفي سائر الصفحة. */
export function printSheet() {
  document.body.classList.add('print-solo');
  const done = () => { document.body.classList.remove('print-solo'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}
