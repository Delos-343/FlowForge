REVOKE EXECUTE ON FUNCTION public.get_user_tenant(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.can_edit(uuid, uuid) FROM anon, public;