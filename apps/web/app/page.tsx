import Link from "next/link";

const LOOP_PHASES = [
  "Discover",
  "Investigate",
  "Interpret",
  "Stake",
  "Defend",
  "Judgment",
] as const;

export default function LandingPage() {
  return (
    <div>
      <section className="relative min-h-[80vh] flex flex-col justify-center items-center px-container-padding py-24 border-b border-outline-variant">
        <div className="relative z-10 max-w-4xl mx-auto text-center space-y-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/30 bg-primary/10 text-primary font-data-label text-data-label uppercase tracking-widest">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            StudioNet Live
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tighter text-on-surface">
            Put money behind your <br />
            <span className="text-primary-container">interpretation of a protocol.</span>
          </h1>
          <p className="max-w-2xl mx-auto text-on-surface-variant font-body-md text-body-md leading-relaxed">
            Investigate ambiguous Web3 claims. Build interpretations. Find contradictions.
            Stake GEN. Let GenLayer judge the evidence.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <Link
              href="/claims"
              className="px-8 py-3 bg-primary-container text-on-primary-container font-data-label text-data-label uppercase tracking-widest border border-primary-container hover:bg-surface-tint transition-colors"
            >
              Enter the Hunt Board
            </Link>
            <Link
              href="/how-it-works"
              className="px-8 py-3 bg-transparent text-on-surface font-data-label text-data-label uppercase tracking-widest border border-outline-variant hover:bg-surface-container-high transition-colors"
            >
              How it Works
            </Link>
          </div>
        </div>
      </section>

      <section className="py-24 px-container-padding border-b border-outline-variant bg-surface-container-lowest">
        <div className="max-w-6xl mx-auto">
          <h2 className="font-headline-md text-headline-md text-on-surface mb-2">Operational Loop</h2>
          <p className="font-code-sm text-code-sm text-on-surface-variant mb-12">
            AMBIGUITY → INTERPRETATION → EVIDENCE → ADVERSARIAL CHALLENGE → GENLAYER JUDGMENT → REPUTATION
          </p>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
            {LOOP_PHASES.map((phase, i) => (
              <div
                key={phase}
                className="bg-surface border border-outline-variant p-4 flex flex-col items-center text-center gap-2"
              >
                <div className="font-data-label text-data-label text-primary">PHASE 0{i + 1}</div>
                <div className="font-body-md text-body-md text-on-surface">{phase}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-24 px-container-padding">
        <div className="max-w-6xl mx-auto text-center">
          <h2 className="font-headline-md text-headline-md text-on-surface mb-4">
            Declared Reality vs. Observed Reality
          </h2>
          <p className="max-w-2xl mx-auto text-on-surface-variant font-body-md text-body-md mb-8">
            Every claim compares what a protocol says against what governance decided against
            what the blockchain actually did — and a GenLayer Intelligent Contract fetches the
            live evidence itself before ruling on the gap.
          </p>
          <Link
            href="/claims"
            className="inline-block px-6 py-2 bg-transparent text-primary font-data-label text-data-label uppercase tracking-widest border border-primary hover:bg-primary/10 transition-colors"
          >
            Browse Active Investigations
          </Link>
        </div>
      </section>
    </div>
  );
}
