import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useLocation } from 'wouter';
import { useAuth } from '@/context/AuthContext';
import { Spinner } from '@/components/ui/spinner';

// Create form schema
const registerSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  confirmPassword: z.string().min(6, 'Password must be at least 6 characters'),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ['confirmPassword'],
});

type RegisterFormValues = z.infer<typeof registerSchema>;

export default function Register() {
  const { checkAuth } = useAuth();
  const [, navigate] = useLocation();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);

  // Initialize form with react-hook-form
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      username: '',
      password: '',
      confirmPassword: '',
    },
  });

  // Handle form submission
  const onSubmit = async (data: RegisterFormValues) => {
    try {
      setIsRegistering(true);
      setErrorMessage(null);
      
      const response = await fetch('/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: data.username,
          password: data.password,
          role: 'user', // Default role
        }),
      });
      
      if (response.ok) {
        await checkAuth(); // Update authentication state
        navigate('/');
      } else {
        const error = await response.json();
        setErrorMessage(error.error || 'Registration failed');
      }
    } catch (error) {
      console.error('Registration error:', error);
      setErrorMessage('An error occurred during registration');
    } finally {
      setIsRegistering(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-bold text-gray-900">Perfect Game</h1>
          <p className="mt-2 text-gray-600">Create your account</p>
        </div>
        
        {errorMessage && (
          <div className="mb-4 rounded bg-red-100 p-3 text-red-700">
            {errorMessage}
          </div>
        )}
        
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-sm font-medium text-gray-700">
              Username
            </label>
            <input
              id="username"
              type="text"
              {...register('username')}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500"
            />
            {errors.username && (
              <p className="mt-1 text-sm text-red-600">{errors.username.message}</p>
            )}
          </div>
          
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700">
              Password
            </label>
            <input
              id="password"
              type="password"
              {...register('password')}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500"
            />
            {errors.password && (
              <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>
            )}
          </div>
          
          <div>
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
              Confirm Password
            </label>
            <input
              id="confirmPassword"
              type="password"
              {...register('confirmPassword')}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500"
            />
            {errors.confirmPassword && (
              <p className="mt-1 text-sm text-red-600">{errors.confirmPassword.message}</p>
            )}
          </div>
          
          <button
            type="submit"
            disabled={isRegistering}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-blue-400"
          >
            {isRegistering ? (
              <span className="flex items-center justify-center">
                <Spinner size="sm" className="mr-2" /> Creating account...
              </span>
            ) : (
              'Create Account'
            )}
          </button>
          
          <div className="mt-4 text-center text-sm">
            <span className="text-gray-600">Already have an account? </span>
            <a 
              href="/login" 
              className="font-medium text-blue-600 hover:text-blue-500"
              onClick={(e) => {
                e.preventDefault();
                navigate('/login');
              }}
            >
              Sign in
            </a>
          </div>
        </form>
      </div>
    </div>
  );
}