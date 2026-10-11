// Acá está la ubicación: GPS del celular, búsqueda de direcciones (OpenStreetMap) y enlaces para llegar
export const BARRANQUILLA = { lat: 10.9685, lng: -74.7813 };

export function getPosition({ timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Este celular no permite ubicación.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? 'Activa el permiso de ubicación para esta app.' : 'No se pudo obtener la ubicación.')),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 }
    );
  });
}

const NOMINATIM = 'https://nominatim.openstreetmap.org';

// Convierte coordenadas en dirección y barrio
export async function reverseGeocode(lat, lng) {
  const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1&accept-language=es`);
  if (!r.ok) return null;
  const d = await r.json();
  const a = d.address || {};
  const street = [a.road, a.house_number].filter(Boolean).join(' ');
  return {
    address: street || d.display_name?.split(',').slice(0, 2).join(',') || '',
    neighborhood: a.neighbourhood || a.suburb || a.quarter || a.city_district || ''
  };
}

// Busca una dirección escrita, dando prioridad a la ciudad de la ruta
export async function searchAddress(text, city = 'Barranquilla') {
  const q = encodeURIComponent(`${text}, ${city}, Colombia`);
  const r = await fetch(`${NOMINATIM}/search?format=jsonv2&q=${q}&countrycodes=co&limit=1&accept-language=es`);
  if (!r.ok) return null;
  const [hit] = await r.json();
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
}

export function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export const googleMapsUrl = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
export const wazeUrl = (lat, lng) => `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
