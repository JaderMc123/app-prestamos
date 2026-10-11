import { useEffect, useRef, useState } from 'preact/hooks';

// Recuadro para que el cliente firme con el dedo; entrega la firma como imagen
export function SignaturePad({ onChange }) {
  const canvas = useRef(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = canvas.current;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio;
    c.height = c.offsetHeight * ratio;
    const ctx = c.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#121212';
  }, []);

  const point = (e) => {
    const r = canvas.current.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const down = (e) => {
    drawing.current = true;
    canvas.current.setPointerCapture(e.pointerId);
    const ctx = canvas.current.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(...point(e));
  };
  const move = (e) => {
    if (!drawing.current) return;
    const ctx = canvas.current.getContext('2d');
    ctx.lineTo(...point(e));
    ctx.stroke();
    if (empty) setEmpty(false);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    canvas.current.toBlob((b) => onChange(b), 'image/png');
  };
  const clear = () => {
    const c = canvas.current;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    setEmpty(true);
    onChange(null);
  };

  return (
    <div class="signature">
      <canvas ref={canvas} class="signature-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label="Firma del cliente" />
      {empty ? <span class="signature-hint">Firma aquí con el dedo</span> : <button type="button" class="link-btn signature-clear" onClick={clear}>Borrar firma</button>}
    </div>
  );
}
