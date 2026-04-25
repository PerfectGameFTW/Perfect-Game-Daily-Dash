import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/hooks/use-toast';
import {
  Trash2,
  UserPlus,
  X,
  Shield,
  User as UserIcon,
  AlertCircle,
  LoaderCircle,
  Mail,
  Pencil,
  Check,
  KeyRound,
  Send,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from '@/components/ui/spinner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Create user schema. The optional email accepts either a well-formed
// address or an empty string (which the submit handler strips so we
// don't send `email: ""` to the backend).
const userSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['user', 'admin']).default('user'),
  email: z
    .string()
    .trim()
    .max(254)
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: 'Must be a valid email address (or leave blank)',
    })
    .optional()
    .default(''),
});

type UserFormValues = z.infer<typeof userSchema>;

// User type definition. `email` is the recovery address used by the
// password-reset flow — null when the account hasn't been enrolled.
// `mustRotatePassword` is set on every account whose password predates
// the strong-password policy (Task #55) and stays true until the user
// successfully changes it. Surfacing it here lets admins see at a
// glance who still has a weak legacy password and nudge them to
// rotate (Task #99).
interface User {
  id: number;
  username: string;
  role: string;
  email: string | null;
  mustRotatePassword: boolean;
}

export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const { toast } = useToast();

  // Initialize form with react-hook-form
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<UserFormValues>({
    resolver: zodResolver(userSchema),
    defaultValues: {
      username: '',
      password: '',
      role: 'user',
      email: '',
    },
  });

  // Inline-edit state for the per-row recovery email. Only one row can
  // be in edit mode at a time; entering edit on a new row replaces the
  // previous draft so a stale value never gets committed to the wrong
  // user.
  const [editingEmailUserId, setEditingEmailUserId] = useState<number | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [savingEmailUserId, setSavingEmailUserId] = useState<number | null>(null);

  // Per-row "Send reset link" pending flags (Task #116). A Set keyed by
  // user id so two admins sending resets to different rows in quick
  // succession each see their own spinner — a single id would race and
  // briefly clear the spinner of one row when the other request settles.
  const [sendingResetUserIds, setSendingResetUserIds] = useState<Set<number>>(
    () => new Set(),
  );

  // Filter toggle for the password-rotation rollout (Task #99). When
  // on, the table is narrowed to accounts whose `mustRotatePassword`
  // is still true so an admin can see exactly who hasn't completed
  // the rotation. Defaults off so the page still shows the full
  // roster on first open.
  const [showOnlyWeakPasswords, setShowOnlyWeakPasswords] = useState(false);
  const weakPasswordCount = users.filter((u) => u.mustRotatePassword).length;
  const visibleUsers = showOnlyWeakPasswords
    ? users.filter((u) => u.mustRotatePassword)
    : users;

  // Fetch users
  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/auth/users', { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (response.ok) {
        const data = await response.json();
        setUsers(data);
      } else {
        toast({
          title: 'Error',
          description: 'Failed to fetch users',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error fetching users:', error);
      toast({
        title: 'Error',
        description: 'An unexpected error occurred',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  // Load users on component mount
  useEffect(() => {
    fetchUsers();
  }, []);

  // Handle user creation
  const handleCreateUser = async (data: UserFormValues) => {
    try {
      // Strip an empty email so the backend's optional-email branch
      // is taken — sending `email: ""` would fail the server-side
      // adminCreateUserSchema (which requires a valid address when
      // the field is present).
      const trimmedEmail = (data.email ?? '').trim();
      const payload: Record<string, unknown> = {
        username: data.username,
        password: data.password,
        role: data.role,
      };
      if (trimmedEmail !== '') payload.email = trimmedEmail;

      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        toast({
          title: 'Success',
          description: `User "${data.username}" created successfully`,
        });
        // Reset form and refresh user list
        reset();
        setCreateDialogOpen(false);
        fetchUsers();
      } else {
        const errorData = await response.json();
        toast({
          title: 'Error',
          description: errorData.error || 'Failed to create user',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error creating user:', error);
      toast({
        title: 'Error',
        description: 'An unexpected error occurred',
        variant: 'destructive',
      });
    }
  };

  // Handle user deletion
  const confirmDeleteUser = (user: User) => {
    // Don't allow deleting yourself
    if (user.id === currentUser?.id) {
      toast({
        title: 'Error',
        description: 'You cannot delete your own account',
        variant: 'destructive',
      });
      return;
    }

    setUserToDelete(user);
    setDeleteDialogOpen(true);
  };

  const handleDeleteUser = async () => {
    if (!userToDelete) return;

    try {
      setLoading(true);
      const response = await fetch(`/api/auth/users/${userToDelete.id}`, {
        method: 'DELETE',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });

      if (response.ok) {
        toast({
          title: 'Success',
          description: `User "${userToDelete.username}" deleted successfully`,
        });
        setDeleteDialogOpen(false);
        setUserToDelete(null);
        fetchUsers();
      } else {
        const errorData = await response.json();
        toast({
          title: 'Error',
          description: errorData.error || 'Failed to delete user',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error deleting user:', error);
      toast({
        title: 'Error',
        description: 'An unexpected error occurred',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  // Send a password-reset link to a target user from the admin
  // console (Task #116). Calls the admin-scoped endpoint, which
  // bypasses the public 3/hr/IP anti-enumeration limiter and surfaces
  // real failures (no email on file, SendGrid down, etc.) instead of
  // the generic OK the public endpoint returns. The button is already
  // disabled when `user.email` is empty; the server-side guard is the
  // authoritative check.
  const handleSendResetLink = async (user: User) => {
    if (!user.email) return;
    try {
      setSendingResetUserIds((prev) => {
        const next = new Set(prev);
        next.add(user.id);
        return next;
      });
      const response = await fetch(`/api/auth/users/${user.id}/send-reset-link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      if (response.ok) {
        toast({
          title: 'Reset link sent',
          description: `A password reset email has been sent to ${user.username}'s recovery address.`,
        });
      } else {
        const errorData = await response.json().catch(() => ({}));
        toast({
          title: 'Failed to send reset link',
          description: errorData.error || 'Could not send the reset email.',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error sending reset link:', error);
      toast({
        title: 'Error',
        description: 'An unexpected error occurred',
        variant: 'destructive',
      });
    } finally {
      setSendingResetUserIds((prev) => {
        const next = new Set(prev);
        next.delete(user.id);
        return next;
      });
    }
  };

  const handleCreateDialogClose = () => {
    setCreateDialogOpen(false);
    reset();
  };

  // Begin editing a row's recovery email. Pre-fill with the existing
  // value so the admin sees what's currently on file.
  const startEditEmail = (user: User) => {
    setEditingEmailUserId(user.id);
    setEmailDraft(user.email ?? '');
  };

  const cancelEditEmail = () => {
    setEditingEmailUserId(null);
    setEmailDraft('');
  };

  // Persist the edited recovery email. Empty string clears the email
  // (and disables password recovery for the account); the server-side
  // schema accepts both shapes. Optimistic updates are intentionally
  // skipped — the round trip is fast and we want the toast/error to
  // come from the actual server response.
  const handleSaveEmail = async (userId: number) => {
    const trimmed = emailDraft.trim();
    // Cheap client-side guard mirroring the server schema so a typo
    // doesn't burn an HTTP round trip.
    if (trimmed !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      toast({
        title: 'Invalid email',
        description: 'Enter a valid email address or leave the field blank.',
        variant: 'destructive',
      });
      return;
    }
    try {
      setSavingEmailUserId(userId);
      const response = await fetch(`/api/auth/users/${userId}/email`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ email: trimmed }),
      });
      if (response.ok) {
        toast({
          title: 'Email updated',
          description:
            trimmed === ''
              ? 'Recovery email cleared. Password reset is now disabled for this account.'
              : `Recovery email set to ${trimmed}.`,
        });
        cancelEditEmail();
        fetchUsers();
      } else {
        const errorData = await response.json().catch(() => ({}));
        toast({
          title: 'Update failed',
          description: errorData.error || 'Could not update email.',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error updating user email:', error);
      toast({
        title: 'Error',
        description: 'An unexpected error occurred',
        variant: 'destructive',
      });
    } finally {
      setSavingEmailUserId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold text-gray-800">User Accounts</h2>
          {loading && <Spinner size="sm" className="text-blue-600" />}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Password-rotation filter (Task #99). The button doubles as
              a live count of accounts still on the legacy weak password
              so admins can see at a glance how the rollout is going. */}
          <Button
            type="button"
            variant={showOnlyWeakPasswords ? 'default' : 'outline'}
            size="sm"
            className="gap-2"
            onClick={() => setShowOnlyWeakPasswords((v) => !v)}
            title={
              showOnlyWeakPasswords
                ? 'Showing only accounts that still have a legacy weak password. Click to show all.'
                : 'Show only accounts that still have a legacy weak password.'
            }
            disabled={users.length === 0}
          >
            <KeyRound className="h-4 w-4" />
            {showOnlyWeakPasswords
              ? `Showing ${weakPasswordCount} weak password${weakPasswordCount === 1 ? '' : 's'} — clear filter`
              : `Weak passwords (${weakPasswordCount})`}
          </Button>

          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <UserPlus className="h-4 w-4" />
              Add User
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New User</DialogTitle>
              <DialogDescription>
                Add a new user account to the system.
              </DialogDescription>
            </DialogHeader>
            
            <form onSubmit={handleSubmit(handleCreateUser)}>
              <div className="grid gap-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="username" className="text-right">
                    Username
                  </Label>
                  <Input
                    id="username"
                    {...register('username')}
                    autoComplete="off"
                    className="text-black"
                  />
                  {errors.username && (
                    <p className="text-xs text-red-500">{errors.username.message}</p>
                  )}
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-right">
                    Password
                  </Label>
                  <Input
                    id="password"
                    type="password"
                    {...register('password')}
                    autoComplete="new-password"
                    className="text-black"
                  />
                  {errors.password && (
                    <p className="text-xs text-red-500">{errors.password.message}</p>
                  )}
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-right">
                    Recovery email <span className="text-xs font-normal text-gray-500">(optional)</span>
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="user@example.com"
                    {...register('email')}
                    autoComplete="off"
                    className="text-black"
                  />
                  {errors.email && (
                    <p className="text-xs text-red-500">{errors.email.message}</p>
                  )}
                  <p className="text-xs text-gray-500">
                    Used by the password-reset flow. Leave blank to skip — you can add one later.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="role" className="text-right">
                    Role
                  </Label>
                  <Select 
                    defaultValue="user" 
                    onValueChange={(value) => {
                      const event = {
                        target: { value }
                      } as unknown as React.ChangeEvent<HTMLSelectElement>;
                      register('role').onChange(event);
                    }}
                  >
                    <SelectTrigger className="text-black">
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                    <SelectContent className="text-black">
                      <SelectItem value="user">Regular User</SelectItem>
                      <SelectItem value="admin">Administrator</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleCreateDialogClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create User'
                  )}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <div className="rounded-md border">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr className="bg-gray-50">
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  User
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Role
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Recovery Email
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {loading && users.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center">
                    <div className="flex justify-center">
                      <Spinner className="h-8 w-8 text-blue-600" />
                    </div>
                    <p className="mt-2 text-sm text-gray-500">Loading users...</p>
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <AlertCircle className="h-8 w-8 text-gray-400" />
                      <p className="text-sm text-gray-500">No users found</p>
                    </div>
                  </td>
                </tr>
              ) : visibleUsers.length === 0 ? (
                // Filter is on but every account has already rotated.
                // A celebratory empty state is more useful than an
                // ambiguous "no users found" — it confirms the rollout
                // is complete and tells the admin how to get back to
                // the full list.
                <tr>
                  <td colSpan={4} className="py-8 text-center">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Check className="h-8 w-8 text-green-500" />
                      <p className="text-sm text-gray-700">
                        Every account has rotated to the new password policy.
                      </p>
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        onClick={() => setShowOnlyWeakPasswords(false)}
                      >
                        Show all users
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : (
                visibleUsers.map((user) => (
                  <tr key={user.id} className={user.id === currentUser?.id ? 'bg-blue-50' : ''}>
                    <td className="whitespace-nowrap px-6 py-4">
                      <div className="flex items-center">
                        <div className="h-10 w-10 flex-shrink-0">
                          <div className={`h-full w-full rounded-full flex items-center justify-center ${
                            user.role === 'admin' ? 'bg-purple-100' : 'bg-blue-100'
                          }`}>
                            {user.role === 'admin' ? (
                              <Shield className="h-5 w-5 text-purple-600" />
                            ) : (
                              <UserIcon className="h-5 w-5 text-blue-600" />
                            )}
                          </div>
                        </div>
                        <div className="ml-4">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-gray-900">
                            <span>{user.username}</span>
                            {user.id === currentUser?.id && (
                              <span className="text-xs font-normal text-blue-600">(You)</span>
                            )}
                            {/* Legacy-password badge (Task #99). Shown
                                whenever the account still has the
                                pre-policy weak password and hasn't
                                completed a rotation. */}
                            {user.mustRotatePassword && (
                              <span
                                className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                                title="This account still has its pre-policy weak password and has not completed the required rotation yet."
                              >
                                <KeyRound className="h-3 w-3" />
                                Legacy password
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500">ID: {user.id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          user.role === 'admin'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-green-100 text-green-800'
                        }`}
                      >
                        {user.role}
                      </span>
                    </td>
                    <td className="px-6 py-4 align-middle">
                      {editingEmailUserId === user.id ? (
                        <div className="flex items-center gap-2">
                          <Input
                            type="email"
                            value={emailDraft}
                            onChange={(e) => setEmailDraft(e.target.value)}
                            placeholder="user@example.com"
                            className="h-8 max-w-[16rem] text-black"
                            autoFocus
                            disabled={savingEmailUserId === user.id}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="default"
                            className="h-8 gap-1"
                            onClick={() => handleSaveEmail(user.id)}
                            disabled={savingEmailUserId === user.id}
                            title="Save email"
                          >
                            {savingEmailUserId === user.id ? (
                              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-8"
                            onClick={cancelEditEmail}
                            disabled={savingEmailUserId === user.id}
                            title="Cancel"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-gray-400" />
                          {user.email ? (
                            <span className="text-sm text-gray-800 break-all">{user.email}</span>
                          ) : (
                            <span className="text-xs italic text-gray-400">
                              No email — password reset disabled
                            </span>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-gray-500 hover:text-gray-700"
                            onClick={() => startEditEmail(user)}
                            title={user.email ? 'Edit email' : 'Add recovery email'}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        {/* Send reset link (Task #116). Only enabled
                            when the row has a recovery email — without
                            one the server-side guard would refuse and
                            we'd be promising an action that can't run.
                            The endpoint is admin-only and bypasses the
                            public 3/hr/IP anti-enumeration limiter. */}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleSendResetLink(user)}
                          disabled={!user.email || sendingResetUserIds.has(user.id)}
                          className={`text-blue-600 hover:bg-blue-100 hover:text-blue-700 ${
                            !user.email ? 'cursor-not-allowed opacity-50' : ''
                          }`}
                          title={
                            user.email
                              ? `Send a password-reset link to ${user.email}`
                              : 'Add a recovery email before sending a reset link'
                          }
                        >
                          {sendingResetUserIds.has(user.id) ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                          ) : (
                            <Send className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => confirmDeleteUser(user)}
                          disabled={user.id === currentUser?.id}
                          className={`text-red-600 hover:bg-red-100 hover:text-red-700 ${
                            user.id === currentUser?.id ? 'cursor-not-allowed opacity-50' : ''
                          }`}
                          title={user.id === currentUser?.id ? "You cannot delete your own account" : ''}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      
      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {userToDelete?.username}'s account and all associated data.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setUserToDelete(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDeleteUser} 
              className="bg-red-600 hover:bg-red-700"
            >
              {loading ? (
                <>
                  <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete User'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}