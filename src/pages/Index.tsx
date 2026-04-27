import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

export default function Index() {
  const { session, loading } = useAuth();
  if (loading) return null;
  return <Navigate to={session ? "/dashboard" : "/auth"} replace />;
}
