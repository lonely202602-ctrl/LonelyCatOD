import { useEffect, useState } from 'react';

/**
 * hash 路由：#/ 是文档列表，#/doc/<id> 是编辑页。
 * 用 hash 而不是 history API，这样 Electron 以 file:// 打开构建产物时也能工作。
 */
export type Route = { page: 'list' } | { page: 'editor'; docId: string };

function parse(): Route {
  const m = location.hash.match(/^#\/doc\/([\w-]+)/);
  return m ? { page: 'editor', docId: m[1] } : { page: 'list' };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
