// 六位數字圖形驗證碼（畫在 canvas，含干擾線與雜點）
const rnd = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };

export function mountCaptcha(box) {
  box.innerHTML = `<div class="cap-label">安全驗證碼（六位數字）</div>
    <div class="cap-row"><canvas width="300" height="64" aria-label="驗證碼圖片"></canvas>
    <button type="button" class="cap-refresh">↻ 重新產生</button></div>
    <input class="cap-input" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="輸入圖中六位數字" />`;
  const cv = box.querySelector('canvas'); const ctx = cv.getContext('2d'); const input = box.querySelector('.cap-input');
  let code = '';

  function draw() {
    code = Array.from({ length: 6 }, () => rnd(10)).join('');
    const w = cv.width, h = cv.height;
    ctx.fillStyle = '#f1f3f1'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 700; i++) { ctx.fillStyle = `rgba(${rnd(120)},${rnd(120)},${rnd(120)},0.35)`; ctx.fillRect(rnd(w), rnd(h), 1 + rnd(2), 1 + rnd(2)); }
    for (let i = 0; i < 5; i++) {
      ctx.strokeStyle = `rgba(${rnd(150)},${rnd(150)},${rnd(150)},0.55)`; ctx.lineWidth = 1 + rnd(2);
      ctx.beginPath(); ctx.moveTo(0, rnd(h)); ctx.bezierCurveTo(w / 3, rnd(h), (2 * w) / 3, rnd(h), w, rnd(h)); ctx.stroke();
    }
    for (let i = 0; i < 6; i++) {
      ctx.save();
      ctx.translate(26 + i * 44 + rnd(6), h / 2 + 4 + rnd(8) - 4);
      ctx.rotate(((rnd(50) - 25) * Math.PI) / 180);
      ctx.font = `bold ${34 + rnd(8)}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgb(${rnd(80)},${rnd(80)},${rnd(80)})`;
      ctx.fillText(code[i], 0, 0);
      ctx.restore();
    }
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = `rgba(${rnd(100)},${rnd(100)},${rnd(100)},0.6)`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, rnd(h)); ctx.lineTo(w, rnd(h)); ctx.stroke();
    }
    input.value = '';
  }

  box.querySelector('.cap-refresh').addEventListener('click', draw);
  draw();
  return {
    refresh: draw,
    verify: () => input.value.trim() === code,
  };
}
