// 2026-11-11 (Midnight & Cobalt): the right-hand panel of sign-in and sign-up - a soft cobalt sky with grain
// and one example of what Euliv does (an answer with its proof trail). Decorative: the form on the left is the page.
export default function AuthArt() {
  return (
    <section aria-label="What Euliv does" className="eu-auth-art">
      <div className="eu-auth-dots" aria-hidden="true" />
      <svg className="eu-auth-grain" aria-hidden="true">
        <filter id="eu-auth-grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" /></filter>
        <rect width="100%" height="100%" filter="url(#eu-auth-grain)" />
      </svg>
      <span className="eu-auth-tag">EXAMPLE ANSWER</span>
      <div className="eu-auth-card">
        <p className="eu-auth-q">Which regions grew fastest this quarter, and is it real or noise?</p>
        <div className="eu-auth-trail">
          <div className="eu-auth-rail" aria-hidden="true"><i className="on" /><b /><i /><b /><i className="ok" /></div>
          <div className="eu-auth-steps">
            <p className="eu-auth-a">West grew fastest, and the gap is statistically real, not a seasonal blip.</p>
            <div className="eu-auth-bars" aria-hidden="true"><span style={{ height: "38%" }} /><span style={{ height: "52%" }} /><span style={{ height: "46%" }} /><span className="hi" style={{ height: "92%" }} /></div>
            <p className="eu-auth-step"><span>STEP 1 · SQL</span> every row, in your warehouse</p>
            <p className="eu-auth-step"><span>STEP 2 · PYTHON</span> a significance test</p>
            <p className="eu-auth-step ok"><span>CHECKED</span> numbers match the source</p>
          </div>
        </div>
      </div>
      <div className="eu-auth-chips">
        <span><b>SQL → Python</b> step by step</span>
        <span>Every number <b>traced</b> to its query</span>
      </div>
    </section>
  );
}
