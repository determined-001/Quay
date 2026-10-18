import SessionGate from "../../components/SessionGate";
import { LinkDetailClient } from "./LinkDetailClient";

export default async function LinkDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <SessionGate>
      <LinkDetailClient id={id} />
    </SessionGate>
  );
}
