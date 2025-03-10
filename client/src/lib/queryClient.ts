import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  methodOrUrl: string,
  urlOrOptions?: string | RequestInit,
  optionsOrUndefined?: RequestInit
): Promise<any> {
  let method = 'GET';
  let url: string;
  let options: RequestInit = {};

  // Handle different parameter patterns
  if (urlOrOptions && typeof urlOrOptions === 'string') {
    // First form: apiRequest('GET', '/api/endpoint')
    method = methodOrUrl;
    url = urlOrOptions;
    options = optionsOrUndefined || {};
  } else {
    // Second form: apiRequest('/api/endpoint', {options})
    url = methodOrUrl;
    options = (urlOrOptions as RequestInit) || {};
  }

  const defaultOptions: RequestInit = {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
  };

  const mergedOptions = { ...defaultOptions, ...options };
  
  console.log(`API request: ${method} ${url}`);
  try {
    const res = await fetch(url, mergedOptions);
    await throwIfResNotOk(res);
    
    // Try to parse as JSON if the content exists and is JSON
    if (res.headers.get('content-type')?.includes('application/json')) {
      return res.json();
    }
    
    return res;
  } catch (error) {
    console.error(`API request failed: ${method} ${url}`, error);
    throw error;
  }
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey[0] as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
