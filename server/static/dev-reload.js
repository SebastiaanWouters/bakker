(() => {
  const connect = () => {
    const source = new EventSource("/api/dev-reload");
    source.addEventListener("reload", () => {
      window.location.reload();
    });
    source.addEventListener("error", () => {
      source.close();
      setTimeout(connect, 1000);
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connect);
  } else {
    connect();
  }
})();
