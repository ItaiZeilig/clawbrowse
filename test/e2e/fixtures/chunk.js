// Lazy route chunk: burn the main thread (a long task, like parsing/running a big bundle), then render.
const t = performance.now(); while (performance.now() - t < 350) {}
setTimeout(() => {
  document.getElementById('app').innerHTML = '<h2>21 results returned</h2>' +
    ['easyJet $55', 'Swiss $87', 'British Airways $92'].map((x) => '<button>' + x + '</button>').join('');
}, 150);
