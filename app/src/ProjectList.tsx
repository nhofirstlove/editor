import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";

export function ProjectList() {
  const [projects, setProjects] = useState<string[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch((err: Error) => setError(err.message));
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await api.createProject(name.trim());
      window.location.hash = `#/p/${encodeURIComponent(created.name)}`;
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="page narrow">
      <h1>Projects</h1>
      {projects === null && !error && <p className="muted">Loading…</p>}
      {projects?.length === 0 && <p className="muted">No projects yet. Create one below.</p>}
      {projects && projects.length > 0 && (
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p}>
              <a href={`#/p/${encodeURIComponent(p)}`}>{p}</a>
            </li>
          ))}
        </ul>
      )}

      <h2>New project</h2>
      <form className="row" onSubmit={create}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="client-interview-oct"
          aria-label="Project name"
        />
        <button type="submit" disabled={!name.trim()}>
          Create
        </button>
      </form>
      <p className="muted small">Letters, digits, - and _ only. The project is a folder inside projects/.</p>
      {error && <div className="banner banner-error">{error}</div>}
    </main>
  );
}
