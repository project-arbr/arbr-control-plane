import React from "react";
import { Navigate } from "react-router-dom";

// /requests is now /applications
export default function Requests() {
  return <Navigate to="/applications" replace />;
}
