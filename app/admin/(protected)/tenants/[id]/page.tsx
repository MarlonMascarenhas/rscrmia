import { TenantOverviewClient } from "./_client";
import { PainelDaAssinatura } from "./_assinatura";

interface TenantDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function TenantDetailPage({ params }: TenantDetailPageProps) {
  const { id } = await params;
  return (
    <>
      <TenantOverviewClient id={id} />
      {/* A porta manual da cobrança (migration 0393): Pix por fora, cortesia,
          acordo, webhook que falhou. Vive AQUI e não numa tela própria porque o
          objeto é a organização que o dono já está olhando. */}
      <PainelDaAssinatura organizationId={id} />
    </>
  );
}
