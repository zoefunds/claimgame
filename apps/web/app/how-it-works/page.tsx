export default function HowItWorksPage() {
  return (
    <div className="p-container-padding md:p-8 max-w-3xl mx-auto w-full space-y-6">
      <h1 className="font-headline-lg text-headline-lg text-on-surface">How It Works</h1>
      <p className="font-body-md text-body-md text-on-surface-variant">
        CLAIMGAME is a Web3 strategy game where players investigate what protocols actually
        promised, construct competing interpretations using real evidence, stake GEN behind their
        arguments, and build reputation for being right.
      </p>
      <ol className="list-decimal list-inside space-y-2 font-body-md text-body-md text-on-surface">
        <li>Discover an ambiguous protocol statement.</li>
        <li>Create a claim: your canonical interpretation of what it means, backed by a GEN bond.</li>
        <li>Other players investigate, submit evidence, and can challenge your interpretation.</li>
        <li>If challenged, either party submits the case for GenLayer judgment.</li>
        <li>
          The contract itself fetches every cited evidence source live and asks an LLM for a
          structured verdict; validators must agree on the decision, not the exact wording.
        </li>
        <li>Funds settle automatically according to the verdict — or, if the model is unsure, the
          case goes to human review with a guaranteed resolution path.</li>
        <li>Reputation updates based on outcomes, feeding the season leaderboards.</li>
      </ol>
    </div>
  );
}
