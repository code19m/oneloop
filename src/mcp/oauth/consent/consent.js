// Asks for a project before the app is connected. The server checks this
// too; the check here only spares the person a round trip.
(() => {
  const form = document.querySelector('form');
  if (!form) return;
  form.addEventListener('submit', (event) => {
    const connecting = event.submitter?.value === 'allow';
    if (connecting && !form.querySelector('input[name=project]:checked')) {
      event.preventDefault();
      alert('Select at least one project.');
    }
  });
})();
