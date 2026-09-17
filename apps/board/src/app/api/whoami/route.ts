/**
 * What `lingtai board` asks to tell this board from anything else on its port
 * (#187). It imports nothing, so it answers while a page cannot — no database
 * configured yet, or one that is down — and a board that is up but failing is
 * not reported as *something that is not a Lingtai board*.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ lingtai: "board" });
}
