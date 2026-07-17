export function TopBar() {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="traffic">
          <i className="dot dot-red" />
          <i className="dot dot-yellow" />
          <i className="dot dot-green" />
        </span>
        <span className="brand">AURA</span>
        <span className="brand-sub">Spatial Agentic Management System</span>
      </div>
      <div className="topbar-center">
        <input
          className="cmd-input"
          placeholder="Type a command or search…"
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <span className="cmd-hint">⌘K</span>
      </div>
      <div className="topbar-right">
        <button className="icon-btn" title="New card">＋</button>
        <button className="icon-btn" title="Media">🖼</button>
        <button className="icon-btn" title="Account">👤</button>
        <button className="icon-btn" title="Archive">🗄</button>
      </div>
    </header>
  );
}
