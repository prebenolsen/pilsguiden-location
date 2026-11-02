// Supabase project connection details for the community layer (user-added
// bars, price reports, Google login). See supabase_readme.md for how to
// get these two values and everything else that needs setting up.
//
// The anon key below is NOT a secret — it's meant to be public in the
// frontend bundle. Access control is enforced server-side by Postgres Row
// Level Security (see supabase/schema.sql), not by hiding this key.

export const SUPABASE_URL = "https://rwshsjxwjbnvwgrrnsmc.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3c2hzanh3amJudndncnJuc21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5MzYwMjksImV4cCI6MjA5NzUxMjAyOX0.A4GDWILqE9dAS3GDvoaNzxveLI4_HNSpxmH_SZZy01Y";
