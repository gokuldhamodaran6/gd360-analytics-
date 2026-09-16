import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import TopNav from "../components/TopNav";

export default function Profile() {
  const { user, updateProfile, changePassword } = useAuth();

  const [fullName, setFullName] = useState(user?.full_name || "");
  const [company, setCompany] = useState(user?.company || "");
  const [profileError, setProfileError] = useState("");
  const [profileNotice, setProfileNotice] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordNotice, setPasswordNotice] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);

  const onSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setProfileError("");
    setProfileNotice("");
    setProfileBusy(true);
    try {
      await updateProfile(fullName, company);
      setProfileNotice("Your profile has been updated.");
    } catch (err: any) {
      setProfileError(err?.response?.data?.detail || "Could not update your profile. Please try again.");
    } finally {
      setProfileBusy(false);
    }
  };

  const onChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordError("");
    setPasswordNotice("");

    if (newPassword.length < 8) {
      setPasswordError("Your new password needs to be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("The new password and confirmation do not match.");
      return;
    }

    setPasswordBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setPasswordNotice("Your password has been updated.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      setPasswordError(err?.response?.data?.detail || "Could not change your password. Please try again.");
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <div className="min-h-screen">
      <TopNav />
      <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">
        <div>
          <Link to="/" className="text-sm text-primary hover:underline">&larr; Back to home</Link>
          <h1 className="text-2xl font-extrabold mt-2">Edit profile</h1>
          <p className="text-muted mt-1">Update your name, company, or password at any time.</p>
        </div>

        <form onSubmit={onSaveProfile} className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold">Your information</h2>
          {profileError && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{profileError}</div>}
          {profileNotice && <div className="text-sm text-primary bg-primary/10 border border-primary/30 rounded-lg px-3 py-2">{profileNotice}</div>}
          <div>
            <label className="text-sm text-muted mb-1 block">Email</label>
            <input className="input opacity-70" value={user?.email || ""} disabled />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Full name</label>
            <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Ada Lovelace" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Company</label>
            <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Inc." />
          </div>
          <button className="btn-primary" type="submit" disabled={profileBusy}>
            {profileBusy ? "Saving..." : "Save changes"}
          </button>
        </form>

        <form onSubmit={onChangePassword} className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold">Change password</h2>
          {passwordError && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{passwordError}</div>}
          {passwordNotice && <div className="text-sm text-primary bg-primary/10 border border-primary/30 rounded-lg px-3 py-2">{passwordNotice}</div>}
          <div>
            <label className="text-sm text-muted mb-1 block">Current password</label>
            <input className="input" type="password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">New password</label>
            <input className="input" type="password" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="At least 8 characters" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Confirm new password</label>
            <input className="input" type="password" required minLength={8} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Repeat new password" />
          </div>
          <button className="btn-primary" type="submit" disabled={passwordBusy}>
            {passwordBusy ? "Updating..." : "Update password"}
          </button>
        </form>
      </div>
    </div>
  );
}
