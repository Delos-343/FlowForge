GRANT EXECUTE ON FUNCTION public.get_user_tenant(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.can_edit(uuid, uuid) TO authenticated, anon;