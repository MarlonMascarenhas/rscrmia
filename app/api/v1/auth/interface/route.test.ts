/**
 * GET /api/v1/auth/interface — só o contexto PRÓPRIO, da org do gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));

import { GET } from "./route";

const ORG = "22222222-2222-4222-8222-222222222222";

describe("GET /api/v1/auth/interface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recusado pelo gate (sem sessão/papel): devolve a resposta do gate, sem corpo de interface", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401),
    } as never);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("interface_settings");
    expect(requireRole).toHaveBeenCalledWith("viewer", expect.objectContaining({ resource: "interface" }));
  });

  it("autorizado: devolve a org do gate, as configurações e a assinatura, com no-store", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      org: { orgId: ORG, interface_settings: { preset: "simplificada" } },
    } as never);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { data } = await res.json();
    expect(data.organization_id).toBe(ORG);
    expect(data.interface_settings).toEqual({ preset: "simplificada" });
    expect(data.signature).toBe(JSON.stringify(data.interface_settings));
  });

  it("interface ausente ou inválida na org: cai na completa", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      org: { orgId: ORG, interface_settings: null },
    } as never);
    const { data } = await (await GET()).json();
    expect(data.interface_settings).toEqual({ preset: "completa" });
  });
});
