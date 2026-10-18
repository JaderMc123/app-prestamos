alter type public.user_role add value if not exists 'super_admin';
create type public.discount_type as enum ('porcentaje','fijo');
