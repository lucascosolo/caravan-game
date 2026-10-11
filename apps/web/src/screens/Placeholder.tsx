export function Placeholder({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <section>
      <h1>{title}</h1>
      <p className="hint">{body}</p>
    </section>
  );
}
