export interface JwtPayload {
  sub: string; // user id (JWT standard claim name for "subject")
  email: string;
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
}