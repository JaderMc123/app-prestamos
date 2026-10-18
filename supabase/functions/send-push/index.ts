// Acá se envían las notificaciones al teléfono (Web Push)
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false }
});

let config: { public: string; private: string; secret: string; subject: string } | null = null;

async function getConfig() {
  if (config) return config;
  const { data, error } = await admin.rpc('push_config');
  if (error) throw error;
  config = data;
  webpush.setVapidDetails(data.subject, data.public, data.private);
  return config!;
}

// A dónde lleva la notificación al tocarla
function urlFor(type: string) {
  if (type === 'transferencia_pendiente') return '/notificaciones';
  return '/notificaciones';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');
  try {
    const cfg = await getConfig();
    if (!cfg.secret || req.headers.get('x-push-secret') !== cfg.secret) {
      return new Response('no autorizado', { status: 401 });
    }
    const { notification_id } = await req.json();
    const { data: n } = await admin.from('notifications').select('id,recipient_id,type,title,body,data').eq('id', notification_id).maybeSingle();
    if (!n) return new Response('sin notificación', { status: 404 });
    const { data: subs } = await admin.from('push_subscriptions').select('id,endpoint,p256dh,auth_key').eq('user_id', n.recipient_id);
    const payload = JSON.stringify({ title: n.title, body: n.body, tag: n.id, url: urlFor(n.type), type: n.type });
    let sent = 0;
    await Promise.all(
      (subs || []).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload, { TTL: 86400, urgency: 'high' });
          sent++;
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          // El teléfono ya no acepta notificaciones: se borra la suscripción
          if (code === 404 || code === 410) await admin.from('push_subscriptions').delete().eq('id', s.id);
        }
      })
    );
    return Response.json({ sent });
  } catch (err) {
    return new Response(String((err as Error).message || err), { status: 500 });
  }
});
