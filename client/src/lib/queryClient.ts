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
    
    // Log the response status
    console.log(`API response status: ${res.status} ${res.statusText} for ${method} ${url}`);
    
    await throwIfResNotOk(res);
    
    // Try to parse as JSON if the content exists and is JSON
    if (res.headers.get('content-type')?.includes('application/json')) {
      try {
        const jsonData = await res.json();
        console.log(`API JSON response for ${url}:`, jsonData);
        
        // Convert string numbers to actual numbers for key fields
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
        console.error(`Failed to parse JSON response: ${url}`, error);
        if (error instanceof Error) {
          throw new Error(`Failed to parse JSON response: ${error.message}`);
        } else {
          throw new Error(`Failed to parse JSON response: Unknown error`);
        }
      }
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
    const url = queryKey[0] as string;
    console.log(`QueryClient request: ${url}`);
    
    const res = await fetch(url, {
      credentials: "include",
    });
    
    console.log(`QueryClient response status: ${res.status} ${res.statusText} for ${url}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    
    try {
      const jsonData = await res.json();
      console.log(`QueryClient JSON response for ${url}:`, jsonData);
      
      // Convert string numbers to actual numbers for key fields
      if (typeof jsonData === 'object' && jsonData !== null) {
        // Handle common dashboard fields
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
      console.error(`Failed to parse JSON response: ${url}`, error);
      if (error instanceof Error) {
        throw new Error(`Failed to parse JSON response: ${error.message}`);
      } else {
        throw new Error(`Failed to parse JSON response: Unknown error`);
      }
    }
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
