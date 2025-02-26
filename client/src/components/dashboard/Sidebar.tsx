import { Link, useLocation } from "wouter";
import { Home, BarChart2, DollarSign, GiftIcon, Settings, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent } from "@/components/ui/sheet";

interface SidebarProps {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export default function Sidebar({ open, setOpen }: SidebarProps) {
  const [location] = useLocation();

  // Navigation items
  const navigation = [
    {
      name: "Dashboard",
      href: "/",
      icon: Home,
      current: location === "/" || location === ""
    },
    {
      name: "Reports",
      href: "/reports",
      icon: BarChart2,
      current: location === "/reports"
    },
    {
      name: "Transactions",
      href: "/transactions",
      icon: DollarSign,
      current: location === "/transactions"
    },
    {
      name: "Gift Cards",
      href: "/gift-cards",
      icon: GiftIcon,
      current: location === "/gift-cards"
    },
    {
      name: "Settings",
      href: "/settings",
      icon: Settings,
      current: location === "/settings"
    }
  ];

  // Sidebar content (shared between desktop and mobile)
  const sidebarContent = (
    <>
      <div className="flex items-center h-16 flex-shrink-0 px-4 bg-gray-900">
        <h1 className="text-xl font-semibold text-white">SalesTracker</h1>
      </div>
      <div className="h-0 flex-1 flex flex-col overflow-y-auto">
        <nav className="flex-1 px-2 py-4 space-y-1">
          {navigation.map((item) => (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center px-2 py-2 text-sm font-medium rounded-md group",
                item.current
                  ? "bg-gray-900 text-white"
                  : "text-gray-300 hover:bg-gray-700 hover:text-white"
              )}
            >
              <item.icon
                className={cn(
                  "mr-3 h-6 w-6",
                  item.current ? "text-gray-300" : "text-gray-400"
                )}
              />
              {item.name}
            </Link>
          ))}
        </nav>
      </div>
    </>
  );

  // Desktop sidebar
  const desktopSidebar = (
    <div className="hidden md:flex md:flex-shrink-0">
      <div className="flex flex-col w-64 bg-gray-800">
        {sidebarContent}
      </div>
    </div>
  );

  // Mobile sidebar (using Sheet component)
  const mobileSidebar = (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="left" className="p-0 bg-gray-800 text-white border-r-0 w-64">
        {sidebarContent}
      </SheetContent>
    </Sheet>
  );

  return (
    <>
      {desktopSidebar}
      {mobileSidebar}
    </>
  );
}
