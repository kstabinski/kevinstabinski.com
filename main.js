  // Nav border appears once you leave the very top.
  const nav = document.getElementById('nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  addEventListener('scroll', onScroll, { passive:true });

  // Hero entrance — the single orchestrated moment.
  requestAnimationFrame(() => document.querySelector('.hero')?.classList.add('in'));

  // Active nav link based on the section in view (wayfinding, not decoration).
  const links = [...document.querySelectorAll('.nav-links a')];
  const map = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
  const spy = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting){
        links.forEach(l => l.classList.remove('active'));
        map.get(e.target.id)?.classList.add('active');
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  ['music','store','contact'].forEach(id => {
    const el = document.getElementById(id);
    if (el) spy.observe(el);
  });