DROP POLICY IF EXISTS "update own profile" ON public.profiles;
CREATE POLICY "update own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);