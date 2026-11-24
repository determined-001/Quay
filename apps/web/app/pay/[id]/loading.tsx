import Logo from "../../components/Logo";
import WakingNotice from "../../components/WakingNotice";

/**
 * Streamed immediately while the server fetches the link (issue 5.42), so the
 * checkout shell paints at once instead of waiting on a cold API. It says
 * "loading" first and only mentions the service waking up after the request
 * has been out for a few seconds.
 */
export default function PayLoading() {
  return (
    <main className="shell shell--narrow">
      <div className="panel checkout" aria-busy="true">
        <Logo />
        <div className="status-rail">
          <span className="spinner" aria-hidden />
          Loading payment link…
        </div>
        <WakingNotice pending />
      </div>
    </main>
  );
}
