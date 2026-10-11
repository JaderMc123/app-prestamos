import { supabase } from '../../lib/supabase.js';
import { createStore, useStore } from '../../lib/store.js';

// Acá se escuchan en tiempo real las notificaciones del usuario (contador de no leídas)
const unread = createStore({ count: 0, version: 0 });
let channel = null;

async function recount(userId) {
  const { count } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', userId)
    .is('read_at', null);
  unread.set((s) => ({ count: count || 0, version: s.version + 1 }));
}

export function startNotifications(userId) {
  stopNotifications();
  recount(userId);
  channel = supabase
    .channel('notif-' + userId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` }, () => recount(userId))
    .subscribe();
}

export function stopNotifications() {
  if (channel) supabase.removeChannel(channel);
  channel = null;
}

export const refreshUnread = (userId) => recount(userId);
export const useUnread = () => useStore(unread, (s) => s.count);
export const useNotifVersion = () => useStore(unread, (s) => s.version);
