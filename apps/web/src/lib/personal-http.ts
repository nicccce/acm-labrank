import 'server-only';
import { NextResponse } from 'next/server';
import { api, checkOrigin, readJson, requireAdmin, requireSession } from './http';
export { api, readJson, requireAdmin, requireSession, NextResponse };
export async function requireMemberWrite(request: Request) { checkOrigin(request); return requireSession(request); }
export type RouteContext = { params: Promise<Record<string, string>> };
