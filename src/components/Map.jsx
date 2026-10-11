import { useEffect, useRef, useState } from 'preact/hooks';
import { BARRANQUILLA } from '../lib/geo.js';

// Acá está el mapa (OpenStreetMap con Leaflet). Se descarga solo cuando se abre, para no pesar en el arranque
let leafletPromise = null;
function loadLeaflet() {
  if (!leafletPromise) {
    leafletPromise = Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(([m]) => m.default || m);
  }
  return leafletPromise;
}

const pinIcon = (L, tone = 'lime') => L.divIcon({ className: '', html: `<span class="map-pin tone-${tone}"></span>`, iconSize: [26, 26], iconAnchor: [13, 13] });

function useLeafletMap(ref, center, zoom) {
  const [map, setMap] = useState(null);
  const [L, setL] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let m = null;
    let alive = true;
    loadLeaflet()
      .then((Lf) => {
        if (!alive || !ref.current) return;
        m = Lf.map(ref.current, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], zoom);
        Lf.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
        Lf.control.zoom({ position: 'bottomright' }).addTo(m);
        setL(() => Lf);
        setMap(m);
      })
      .catch(() => alive && setError('No se pudo cargar el mapa. Revisa tu conexión.'));
    return () => {
      alive = false;
      m?.remove();
    };
  }, []);
  return { map, L, error };
}

// Mapa con un punto que se puede arrastrar para corregir la ubicación del cliente
export function MapPicker({ value, onChange, height = 240 }) {
  const ref = useRef(null);
  const marker = useRef(null);
  const start = value?.lat != null ? value : BARRANQUILLA;
  const { map, L, error } = useLeafletMap(ref, start, value?.lat != null ? 17 : 12);

  useEffect(() => {
    if (!map || !L) return;
    marker.current = L.marker([start.lat, start.lng], { draggable: true, icon: pinIcon(L) }).addTo(map);
    marker.current.on('dragend', () => {
      const p = marker.current.getLatLng();
      onChange({ lat: p.lat, lng: p.lng, manual: true });
    });
    map.on('click', (e) => {
      marker.current.setLatLng(e.latlng);
      onChange({ lat: e.latlng.lat, lng: e.latlng.lng, manual: true });
    });
  }, [map]);

  useEffect(() => {
    if (!map || !marker.current || value?.lat == null) return;
    const cur = marker.current.getLatLng();
    if (Math.abs(cur.lat - value.lat) > 1e-6 || Math.abs(cur.lng - value.lng) > 1e-6) {
      marker.current.setLatLng([value.lat, value.lng]);
      map.setView([value.lat, value.lng], Math.max(map.getZoom(), 17));
    }
  }, [value?.lat, value?.lng, map]);

  return (
    <div class="map-box" style={{ height }}>
      <div ref={ref} class="map-canvas" />
      {error && <p class="map-error">{error}</p>}
    </div>
  );
}

// Mapa con varios clientes, cada punto con el color de su estado
export function ClientsMap({ points, onSelect, height = 420 }) {
  const ref = useRef(null);
  const layer = useRef(null);
  const { map, L, error } = useLeafletMap(ref, BARRANQUILLA, 12);

  useEffect(() => {
    if (!map || !L) return;
    layer.current?.remove();
    layer.current = L.layerGroup().addTo(map);
    const located = points.filter((p) => p.lat != null && p.lng != null);
    for (const p of located) {
      L.marker([p.lat, p.lng], { icon: pinIcon(L, p.tone) })
        .addTo(layer.current)
        .bindTooltip(p.label, { direction: 'top', offset: [0, -10] })
        .on('click', () => onSelect?.(p));
    }
    if (located.length) map.fitBounds(L.latLngBounds(located.map((p) => [p.lat, p.lng])), { padding: [30, 30], maxZoom: 16 });
  }, [map, points]);

  return (
    <div class="map-box" style={{ height }}>
      <div ref={ref} class="map-canvas" />
      {error && <p class="map-error">{error}</p>}
    </div>
  );
}
