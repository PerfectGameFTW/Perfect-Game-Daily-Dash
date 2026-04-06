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

  if (urlOrOptions && typeof urlOrOptions === 'string') {
    method = methodOrUrl;
    url = urlOrOptions;
    options = optionsOrUndefined || {};
  } else {
    url = methodOrUrl;
    options = (urlOrOptions as RequestInit) || {};
  }

  const mergedOptions: RequestInit = {
    method,
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(options.headers as Record<string, string>),
    },
  };

  try {
    const res = await fetch(url, mergedOptions);
    await throwIfResNotOk(res);
    
    if (res.headers.get('content-type')?.includes('application/json')) {
      try {
        const jsonData = await res.json();
        
        if (typeof jsonData === 'object' && jsonData !== null) {
          if (jsonData.totalRevenue !== undefined) {
            jsonData.totalRevenue = typeof jsonData.totalRevenue === 'number'
              ? jsonData.totalRevenue
              : parseFloat(jsonData.totalRevenue || '0');
          }
          if (jsonData.revenueChange !== undefined) {
            jsonData.revenueChange = typeof jsonData.revenueChange === 'number'
              ? jsonData.revenueChange
              : parseFloat(jsonData.revenueChange || '0');
          }
          if (jsonData.totalOrders !== undefined) {
            jsonData.totalOrders = typeof jsonData.totalOrders === 'number'
              ? jsonData.totalOrders
              : parseInt(jsonData.totalOrders || '0', 10);
          }
        }
        
        return jsonData;
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to parse JSON response: ${error.message}`);
        }
        throw new Error('Failed to parse JSON response: Unknown error');
      }
    }
    
    return res;
  } catch (error) {
    throw error;
  }
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey[0] as string;
    
    const res = await fetch(url, { credentials: "include", headers: { 'X-Requested-With': 'XMLHttpRequest' } });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    
    try {
      const jsonData = await res.json();
      
      if (typeof jsonData === 'object' && jsonData !== null) {
        if (jsonData.totalRevenue !== undefined) {
          jsonData.totalRevenue = typeof jsonData.totalRevenue === 'number'
            ? jsonData.totalRevenue
            : parseFloat(jsonData.totalRevenue || '0');
        }
        if (jsonData.revenueChange !== undefined) {
          jsonData.revenueChange = typeof jsonData.revenueChange === 'number'
            ? jsonData.revenueChange
            : parseFloat(jsonData.revenueChange || '0');
        }
        if (jsonData.totalOrders !== undefined) {
          jsonData.totalOrders = typeof jsonData.totalOrders === 'number'
            ? jsonData.totalOrders
            : parseInt(jsonData.totalOrders || '0', 10);
        }
      }
      
      return jsonData;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to parse JSON response: ${error.message}`);
      }
      throw new Error('Failed to parse JSON response: Unknown error');
    }
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: true,
      staleTime: 30 * 1000,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
