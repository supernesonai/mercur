import { z } from "zod"

export const loginFormSchema = z.object({
  phone: z.string().nonempty("Please enter your phone number"),
  code: z.string().optional(),
})

export type LoginFormData = z.infer<typeof loginFormSchema>
