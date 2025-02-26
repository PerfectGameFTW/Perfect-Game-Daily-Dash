import { Home, BarChart2, MessageCircle, User, MoreHorizontal } from "lucide-react";

const BottomNavigation = () => {
  return (
    <div className="fixed bottom-0 left-0 right-0 h-16 bg-black border-t border-zinc-800 flex items-center justify-around px-2">
      <NavItem icon={<Home className="w-5 h-5" />} label="Home" active />
      <NavItem icon={<BarChart2 className="w-5 h-5" />} label="Reports" />
      <NavItem icon={<MessageCircle className="w-5 h-5" />} label="Messages" />
      <NavItem icon={<User className="w-5 h-5" />} label="Me" />
      <NavItem icon={<MoreHorizontal className="w-5 h-5" />} label="More" />
    </div>
  );
};

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}

const NavItem = ({ icon, label, active }: NavItemProps) => {
  return (
    <div className="flex flex-col items-center justify-center">
      <div className={`p-2 ${active ? 'text-blue-500' : 'text-zinc-400'}`}>
        {icon}
      </div>
      <span className={`text-xs ${active ? 'text-blue-500' : 'text-zinc-400'}`}>
        {label}
      </span>
    </div>
  );
};

export default BottomNavigation;