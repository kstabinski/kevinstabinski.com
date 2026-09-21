  // Nav border appears once you leave the very top.
  const nav = document.getElementById('nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  addEventListener('scroll', onScroll, { passive:true });

  // Hero entrance — the single orchestrated moment.
  requestAnimationFrame(() => document.querySelector('.hero')?.classList.add('in'));

  // Highlight the nav link for the page you're on.
  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  document.querySelectorAll('.nav-links a').forEach(a => {
    if ((a.getAttribute('href') || '').toLowerCase() === page) a.classList.add('active');
  });

// Click-to-load YouTube players (keeps pages with many videos fast).
document.querySelectorAll('.video-thumb').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.id;
    const wrap = document.createElement('div');
    wrap.className = 'video-embed';
    const f = document.createElement('iframe');
    f.src = `https://www.youtube.com/embed/${id}?autoplay=1`;
    f.title = 'YouTube video player';
    f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    f.allowFullscreen = true;
    wrap.appendChild(f);
    btn.replaceWith(wrap);
  });
});
